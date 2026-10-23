import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { WorkflowClient } from "@temporalio/client";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import proto from "@temporalio/proto";

export const workflowPaths = {
  turns: fileURLToPath(new URL("../../src/workflows.ts", import.meta.url)),
  maintenance: fileURLToPath(new URL("../../src/memory-maintenance-workflows.ts", import.meta.url)),
  mutation: fileURLToPath(new URL("../../src/memory-mutation-workflows.ts", import.meta.url))
};
export const fixtureDirectory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
export const workflowNames = ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow",
  "roomAgentSupervisorWorkflow", "roomAgentActionWorkflow", "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow", "memoryMutationWorkflow"];

const activityNames = ["dotGoalStep", "dotGoalObserve", "recordDummyTurnStarted", "recordDummyTurnCompleted",
  "runCodexAppServerTurn", "runOpenCodeAgentTurn", "runCliAgentTurn", "markRoomAgentMissionStarted",
  "markRoomAgentMissionFinished", "markRoomAgentMissionContinued", "settleRoomAgentBackgroundMission",
  "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn", "finishRoomAgentSupervisorTurn",
  "prepareRoomAgentBackgroundContinuation", "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit", "prepareMemoryConsolidation", "executePersistedMemoryChangeSet", "finalizeMemoryRepair"];

export const turnInput = (suffix = "one", extra = {}) => ({
  roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic regression request",
  artifactIds: [], agentRunId: `agent_run:${suffix}`, permissionMode: null,
  collaborationMode: "default", traceId: `trace:synthetic-${suffix}`, ...extra
});
export const queueItem = (suffix = "one", extra = {}) => ({
  missionId: `mission:${suffix}`, turn: turnInput(suffix, extra)
});
export const verifiedTurn = {
  status: "COMPLETED", message: "Synthetic completion",
  roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic evidence verified." }
};
let runtimeInstalled = false;

export async function eventually(predicate, description = "expected activity", timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}`);
}

// All I/O is substituted at the activity boundary. Temporal's workflow APIs,
// child workflows, signals, history, retries and timers are never mocked.
export async function createSandbox() {
  if (!runtimeInstalled) {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    runtimeInstalled = true;
  }
  const env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-workflow-tests" } });
  const cleanupClient = new WorkflowClient({ connection: env.connection, namespace: env.namespace });
  let stubs = {};
  let inFlightActivities = 0;
  const calls = [];
  const handles = new Set();
  const activities = Object.fromEntries(activityNames.map(name => [name, async (...args) => {
    calls.push({ name, args });
    assert.equal(typeof stubs[name], "function", `Unexpected activity: ${name}`);
    inFlightActivities++;
    try { return await stubs[name](...args); }
    finally { inFlightActivities--; }
  }]));
  const options = {
    connection: env.nativeConnection, identity: "synthetic-workflow-tests", activities,
    shutdownGraceTime: "0ms", shutdownForceTime: "5s",
    maxHeartbeatThrottleInterval: "50ms", defaultHeartbeatThrottleInterval: "50ms",
    bundlerOptions: { webpackConfigHook: config => ({ ...config, stats: "errors-only" }) }
  };
  const workers = [];
  const runs = [];
  const queues = {
    turns: { taskQueue: "synthetic-turns", workflowsPath: workflowPaths.turns },
    legacy: { taskQueue: "synthetic-legacy", workflowsPath: workflowPaths.turns,
      patchActivationCallback: ({ patchId }) => patchId !== "room-background-continuation-v1" },
    maintenance: { taskQueue: "space-memory-maintenance", workflowsPath: workflowPaths.maintenance },
    mutation: { taskQueue: "space-memory-mutations", workflowsPath: workflowPaths.mutation }
  };
  const started = new Set();
  async function ensureWorker(kind) {
    if (started.has(kind)) return;
    // Use the production entry points, starting only the queues needed by this
    // case. The SDK patch hook selects legacy execution without editing code;
    // replay later receives no hook and must infer the branch from history.
    const worker = await Worker.create({ ...options, ...queues[kind] });
    workers.push(worker);
    const run = worker.run();
    runs.push(run);
    void run.catch(() => {});
    await eventually(() => worker.getState() === "RUNNING", "worker to start");
    started.add(kind);
  }

  async function close(handle, { cancel = false } = {}) {
    let current = cleanupClient.getHandle(handle.workflowId, handle.firstExecutionRunId);
    let description = await current.describe();
    while (description.status.name === "CONTINUED_AS_NEW") {
      const history = await current.fetchHistory();
      const event = history.events.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
      current = cleanupClient.getHandle(handle.workflowId, event.workflowExecutionContinuedAsNewEventAttributes.newExecutionRunId);
      description = await current.describe();
    }
    if (description.status.name === "RUNNING") {
      if (cancel) await current.cancel();
      else await current.terminate("Synthetic test execution cleanup");
      // Keep virtual time locked during cancellation acknowledgements. The
      // time-skipping client can otherwise race the child activity's heartbeat
      // timeout while its cancellation and non-cancellable cleanup are in flight.
      await current.result().catch(error => {
        if (error.cause?.name !== (cancel ? "CancelledFailure" : "TerminatedFailure")) throw error;
      });
    }
    await eventually(() => inFlightActivities === 0, "activity cancellation acknowledgements");
    handles.delete(handle);
  }

  return {
    env, calls,
    use(implementations) { stubs = implementations; calls.length = 0; },
    count(name) { return calls.filter(call => call.name === name).length; },
    async start(name, input, { legacy = false, workflowId = `synthetic-${name}-${randomUUID()}` } = {}) {
      const kind = name === "memoryMutationWorkflow" ? "mutation"
        : name.startsWith("memory") ? "maintenance" : legacy ? "legacy" : "turns";
      if (kind === "maintenance") await ensureWorker("mutation");
      await ensureWorker(kind);
      const { taskQueue } = queues[kind];
      const handle = await env.client.workflow.start(name, { taskQueue, workflowId, args: [input] });
      handles.add(handle);
      return handle;
    },
    close,
    async reset() { for (const handle of [...handles]) await close(handle); },
    async history(handle) {
      // Use the generated protobuf binding for a lossless JSON round trip. In
      // particular, preserve 64-bit IDs as strings and payload bytes as base64.
      return proto.temporal.api.history.v1.History.toObject(await handle.fetchHistory(), {
        longs: String, enums: String, bytes: String
      });
    },
    async stop() {
      try { for (const handle of [...handles]) await close(handle); }
      finally {
        for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
        try { await Promise.all(runs); } finally { await env.teardown(); }
      }
    }
  };
}

export function continuedInput(history) {
  const event = history.events.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
  assert.ok(event, "Expected a real WorkflowExecutionContinuedAsNew history event");
  const attributes = event.workflowExecutionContinuedAsNewEventAttributes;
  return { runId: attributes.newExecutionRunId, input: decodePayload(attributes.input.payloads[0]) };
}

export function decodePayload(payload) {
  return JSON.parse(Buffer.from(payload.data, "base64").toString("utf8"));
}

export function scheduledActivities(history) {
  return history.events.flatMap(event => event.activityTaskScheduledEventAttributes ?? []);
}

export function durationSeconds(duration) { return Number(duration.seconds ?? 0) + (duration.nanos ?? 0) / 1e9; }
