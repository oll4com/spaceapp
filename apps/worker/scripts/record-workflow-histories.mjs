#!/usr/bin/env node
/**
 * Records workflow histories for the replay determinism gate.
 *
 * Runs every workflow once against a time-skipping test server with simple
 * synthetic stub activities, and writes the resulting histories as JSON into
 * tests/fixtures/workflow-histories/. The replay test
 * (tests/temporal-replay.test.ts) replays those files against the current
 * workflow code on every test run.
 *
 * Usage:
 *   npm run temporal:record-histories -w @space/worker [-- --force] [-- --address host:port]
 *
 * Existing fixtures are never overwritten unless --force is passed: a replay
 * failure must be fixed in the workflow code (with a replay-safe patched()
 * change), never by quietly re-recording the fixture. See the README in the
 * fixtures directory for the full rule.
 *
 * --address records against an already-running time-skipping test server
 * instead of spawning one (useful on machines where the SDK cannot spawn the
 * server itself).
 */
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import protoPkg from "@temporalio/proto";

const { temporal } = protoPkg;
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../tests/fixtures/workflow-histories");
const workflowsPath = path.resolve(here, "../tests/temporal-workflows-entry.ts");

const args = process.argv.slice(2);
const force = args.includes("--force");
const addressFlag = args.indexOf("--address");
const address = addressFlag >= 0 ? args[addressFlag + 1] : null;

const MAIN_QUEUE = "space-history-recording";
const LEGACY_QUEUE = "space-history-recording-legacy";
const MAINTENANCE_QUEUE = "space-memory-maintenance";
const MUTATION_QUEUE = "space-memory-mutations";

/** Mutable stub registry: scenarios run sequentially and swap implementations. */
const stubs = new Map();
function stub(name, impl) {
  stubs.set(name, impl);
}
function delegate(name) {
  return async (...callArgs) => {
    const impl = stubs.get(name);
    if (!impl) throw new Error(`Recording script has no stub for activity "${name}"`);
    return impl(...callArgs);
  };
}
const ACTIVITY_NAMES = [
  "recordDummyTurnStarted", "recordDummyTurnCompleted", "runCodexAppServerTurn",
  "runOpenCodeAgentTurn", "runCliAgentTurn", "markRoomAgentMissionStarted",
  "markRoomAgentMissionFinished", "markRoomAgentMissionContinued",
  "settleRoomAgentBackgroundMission", "dotGoalStep", "dotGoalObserve",
  "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn",
  "finishRoomAgentSupervisorTurn", "prepareRoomAgentBackgroundContinuation",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot",
  "reconcileStaleSpaceAgentSessions", "createScheduledMemoryAudit",
  "prepareMemoryConsolidation", "finalizeMemoryRepair", "executePersistedMemoryChangeSet"
];
const activities = Object.fromEntries(ACTIVITY_NAMES.map((name) => [name, delegate(name)]));

let recordedCount = 0;
let skippedCount = 0;
async function plan(file, workflowId, fetchHistory) {
  const target = path.join(fixturesDir, file);
  if (existsSync(target) && !force) {
    console.log(`skip ${file} (exists; pass --force to overwrite)`);
    skippedCount += 1;
    return;
  }
  const history = await fetchHistory();
  // Serialize with the same @temporalio/proto classes the client returns, so
  // the fixture round-trips exactly through History.fromObject at replay.
  const payload = {
    workflowId,
    history: temporal.api.history.v1.History.toObject(history, {
      enums: String,
      longs: String,
      bytes: String
    })
  };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`recorded ${file} (${history.events?.length ?? 0} events)`);
  recordedCount += 1;
}

const turn = (overrides = {}) => ({
  roomId: "room:record",
  paneId: "pane:record",
  prompt: "Record a synthetic turn.",
  artifactIds: [],
  permissionMode: null,
  collaborationMode: "default",
  traceId: "trace:record",
  agentRunId: "agent_run:record",
  ...overrides
});
const turnResult = (input, overrides = {}) => ({
  workflowId: `space-turn:${input.traceId}`,
  roomId: input.roomId,
  paneId: input.paneId,
  traceId: input.traceId,
  status: "COMPLETED",
  message: "Recorded turn completed.",
  ...overrides
});
const supervisorItem = {
  missionId: "mission:record",
  turn: turn({ roomAgentMissionId: "mission:record", agentSessionId: "session:record" })
};

async function main() {
  mkdirSync(fixturesDir, { recursive: true });
  const env = address
    ? await TestWorkflowEnvironment.create({
        server: { type: "existing" },
        supportsTimeSkipping: true,
        address,
        namespace: "default"
      })
    : await TestWorkflowEnvironment.createTimeSkipping();

  const workerOptions = {
    connection: env.nativeConnection,
    namespace: "default",
    workflowsPath,
    activities,
    isolateExecutionTimeout: "60 seconds"
  };
  const workers = await Promise.all([
    Worker.create({ ...workerOptions, taskQueue: MAIN_QUEUE }),
    Worker.create({
      ...workerOptions,
      taskQueue: LEGACY_QUEUE,
      patchActivationCallback: ({ patchId }) => patchId !== "room-background-continuation-v1"
    }),
    Worker.create({ ...workerOptions, taskQueue: MAINTENANCE_QUEUE }),
    Worker.create({ ...workerOptions, taskQueue: MUTATION_QUEUE })
  ]);
  let release = () => undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = Promise.all(workers.map((worker) => worker.runUntil(() => gate)));

  const client = env.client;
  const start = (workflowType, taskQueue, workflowId, arg) =>
    client.workflow.start(workflowType, {
      taskQueue,
      workflowId,
      workflowTaskTimeout: "30 seconds",
      args: [arg]
    });
  const sleepUntil = async (predicate, description) => {
    for (let i = 0; i < 600; i += 1) {
      if (await predicate()) return;
      await env.sleep("250 milliseconds");
    }
    throw new Error(`Recording timed out: ${description}`);
  };
  // Fetch a specific run's history through the workflow service: after a
  // continue-as-new, the handle-level fetch follows the new run, so the
  // closing history of the run that continued must be pinned by run id.
  const fetchFirstRunHistory = async (handle) => {
    const events = [];
    let nextPageToken;
    do {
      const response = await env.connection.workflowService.getWorkflowExecutionHistory({
        namespace: "default",
        execution: { workflowId: handle.workflowId, runId: handle.firstExecutionRunId },
        maximumPageSize: 1000,
        nextPageToken
      });
      events.push(...(response.history?.events ?? []));
      nextPageToken = response.nextPageToken?.length ? response.nextPageToken : undefined;
    } while (nextPageToken);
    return temporal.api.history.v1.History.fromObject({ events });
  };
  const continuedAsNew = async (handle) =>
    (await fetchFirstRunHistory(handle)).events.some((e) => e.workflowExecutionContinuedAsNewEventAttributes);
  const firstRunHistory = (handle) => () => fetchFirstRunHistory(handle);

  try {
    // --- dotGoalWorkflow: WAITING step, 30s timer fires, DONE ---------------
    {
      let steps = 0;
      stub("dotGoalStep", async () => {
        steps += 1;
        return steps === 1
          ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
          : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      });
      stub("dotGoalObserve", async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" }));
      const handle = await start("dotGoalWorkflow", MAIN_QUEUE, "record-dot-goal-timeout", { goalId: "goal:record-timeout" });
      await handle.result();
      await plan("dot-goal-timeout.json", handle.workflowId, () => handle.fetchHistory());
    }

    // --- dotGoalWorkflow: PAUSED wait ended by the wake signal --------------
    {
      let steps = 0;
      stub("dotGoalStep", async () => {
        steps += 1;
        return steps === 1
          ? { state: "PAUSED", runId: null, goalStatus: "RUNNING" }
          : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      });
      const handle = await start("dotGoalWorkflow", MAIN_QUEUE, "record-dot-goal-wake", { goalId: "goal:record-wake" });
      await sleepUntil(() => steps === 1, "dot goal to enter its paused wait");
      await env.sleep("30 minutes");
      await handle.signal("dotGoalWake");
      await handle.result();
      await plan("dot-goal-wake.json", handle.workflowId, () => handle.fetchHistory());
    }

    // --- dummyTurnWorkflow ---------------------------------------------------
    {
      stub("recordDummyTurnStarted", async () => undefined);
      stub("recordDummyTurnCompleted", async (input) => ({
        workflowId: "space-dummy-turn:record",
        roomId: input.roomId,
        paneId: input.paneId,
        traceId: input.traceId,
        status: "COMPLETED",
        message: "Recorded."
      }));
      const handle = await start("dummyTurnWorkflow", MAIN_QUEUE, "record-dummy-turn", turn());
      await handle.result();
      await plan("dummy-turn.json", handle.workflowId, () => handle.fetchHistory());
    }

    // --- codexAppServerTurnWorkflow (native Chat path) -----------------------
    {
      stub("runCodexAppServerTurn", async (input) => turnResult(input));
      const handle = await start(
        "codexAppServerTurnWorkflow",
        MAIN_QUEUE,
        "record-codex-turn",
        turn({ agentSessionId: "session:record", agentAssistantMessageId: "agent_msg:record" })
      );
      await handle.result();
      await plan("codex-turn.json", handle.workflowId, () => handle.fetchHistory());
    }

    // --- roomAgentActionWorkflow: the failure path ---------------------------
    {
      stub("runRoomAgentBackgroundAction", async () => {
        throw new Error("transport failed");
      });
      stub("failRoomAgentBackgroundAction", async () => undefined);
      const handle = await start("roomAgentActionWorkflow", MAIN_QUEUE, "space-room-action:action:recorded", {
        bridge: { roomId: "room:record", missionId: "mission:record" },
        traceId: "trace:record"
      });
      await handle.result().catch(() => undefined);
      await plan("room-action-failure.json", handle.workflowId, () => handle.fetchHistory());
    }

    // --- roomAgentSupervisorWorkflow, current branch: a mission completes ----
    {
      let finished = 0;
      stub("checkRoomAgentSupervisorTurn", async () => "READY");
      stub("discardRoomAgentSupervisorTurn", async () => undefined);
      stub("finishRoomAgentSupervisorTurn", async () => {
        finished += 1;
      });
      stub("prepareRoomAgentBackgroundContinuation", async () => ({ state: "WAITING" }));
      stub("runCodexAppServerTurn", async (input) => turnResult(input));
      const handle = await start("roomAgentSupervisorWorkflow", MAIN_QUEUE, "record-supervisor-current", {
        roomId: "room:record",
        pending: [supervisorItem],
        monitoringMissionIds: [],
        processedCount: 0
      });
      await sleepUntil(() => finished === 1, "supervisor to finish the mission");
      await plan("room-supervisor-current.json", handle.workflowId, () => handle.fetchHistory());
      await handle.terminate().catch(() => undefined);
    }

    // --- roomAgentSupervisorWorkflow, current branch: continue-as-new --------
    {
      stub("prepareRoomAgentBackgroundContinuation", async () => ({ state: "WAITING" }));
      const handle = await start("roomAgentSupervisorWorkflow", MAIN_QUEUE, "record-supervisor-current-can", {
        roomId: "room:record",
        pending: [],
        monitoringMissionIds: ["mission:record"],
        processedCount: 50
      });
      await sleepUntil(() => continuedAsNew(handle), "supervisor to continue as new");
      await plan("room-supervisor-current-can.json", handle.workflowId, firstRunHistory(handle));
    }

    // --- roomAgentSupervisorWorkflow, pre-patch branch: continue-as-new ------
    {
      stub("markRoomAgentMissionStarted", async () => undefined);
      stub("markRoomAgentMissionFinished", async () => undefined);
      stub("markRoomAgentMissionContinued", async () => undefined);
      stub("settleRoomAgentBackgroundMission", async () => false);
      stub("runCodexAppServerTurn", async (input) => turnResult(input));
      const handle = await start("roomAgentSupervisorWorkflow", LEGACY_QUEUE, "record-supervisor-pre-patch", {
        roomId: "room:record",
        pending: [supervisorItem],
        monitoringMissionIds: [],
        processedCount: 49
      });
      await sleepUntil(() => continuedAsNew(handle), "legacy supervisor to continue as new");
      await plan("room-supervisor-pre-patch.json", handle.workflowId, firstRunHistory(handle));
    }

    // --- memory workflows ------------------------------------------------------
    {
      const maintenanceResult = {
        status: "REFRESHED",
        generatedAt: "2026-10-16T12:00:00.000Z",
        sourceHash: "source-hash-record",
        previousSourceHash: null,
        summary: { nodeCount: 1, edgeCount: 0 },
        durationMs: 5
      };
      const run = {
        id: "run:record",
        mode: "SCHEDULED",
        triggerKind: "SCHEDULED",
        status: "SUCCEEDED",
        workflowId: "memory-consolidation:record",
        dedupeKey: "dedupe-run-record",
        sourceHash: null,
        actorUserId: null,
        progressCompleted: 1,
        progressTotal: 1,
        findingCount: 0,
        appliedOperationCount: 1,
        skippedOperationCount: 0,
        failedOperationCount: 0,
        metrics: {},
        modelId: null,
        aiVerified: false,
        aiEvidence: {},
        statusReason: null,
        createdAt: "2026-10-16T12:00:00.000Z",
        startedAt: "2026-10-16T12:00:00.000Z",
        completedAt: "2026-10-16T12:00:00.000Z",
        updatedAt: "2026-10-16T12:00:00.000Z"
      };
      stub("refreshMemoryGraphSnapshot", async () => maintenanceResult);
      stub("refreshAllMonthsMemoryGraphSnapshot", async () => maintenanceResult);
      stub("reconcileStaleSpaceAgentSessions", async () => ({ reconciled: 0 }));
      stub("createScheduledMemoryAudit", async () => ({ id: "run:record", workflowId: "memory-consolidation:record" }));
      stub("prepareMemoryConsolidation", async () => ({ run, changeSetId: "changeset:record" }));
      stub("executePersistedMemoryChangeSet", async (input) => ({
        status: "APPLIED",
        changeSetId: input.changeSetId,
        resultingSourceHash: "source-hash-after",
        reason: null
      }));
      stub("finalizeMemoryRepair", async () => run);

      const maintenance = await start("memoryMaintenanceWorkflow", MAIN_QUEUE, "record-memory-maintenance", {
        scheduledAt: "2026-10-16T12:00:00.000Z",
        traceId: "trace:record"
      });
      await maintenance.result();
      await plan("memory-maintenance.json", maintenance.workflowId, () => maintenance.fetchHistory());

      const consolidation = await start("memoryConsolidationWorkflow", MAINTENANCE_QUEUE, "record-memory-consolidation", {
        runId: "run:record",
        traceId: "trace:record"
      });
      await consolidation.result();
      await plan("memory-consolidation.json", consolidation.workflowId, () => consolidation.fetchHistory());

      const mutation = await start("memoryMutationWorkflow", MUTATION_QUEUE, "record-memory-mutation", {
        changeSetId: "changeset:record",
        traceId: "trace:record"
      });
      await mutation.result();
      await plan("memory-mutation.json", mutation.workflowId, () => mutation.fetchHistory());
    }

    console.log(`done: ${recordedCount} recorded, ${skippedCount} skipped`);
  } finally {
    release();
    await running;
    await env.teardown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
