/**
 * Record workflow histories for the replay determinism gate.
 *
 *   SPACE_TEST_TEMPORAL_TEST_SERVER=/path/to/temporal-test-server \
 *     npm run temporal:record-histories -w @space/worker
 *
 * Policy: re-record AFTER any change that alters workflow command sequences,
 * and re-record with the SAME stub activity shapes used here. A history whose
 * run never completed (supervisors idle forever) is snapshotted at a settled
 * point and cancelled; continue-as-new runs record the first run only.
 */
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "..", "tests", "fixtures", "workflow-histories");
const WORKFLOWS_PATH = join(here, "..", "src", "workflows.ts");
const PRE_PATCH_PATH = join(here, "..", "tests", "support", "pre-patch-workflows.ts");
const MAINTENANCE_PATH = join(here, "..", "src", "memory-maintenance-workflows.ts");
const MUTATION_PATH = join(here, "..", "src", "memory-mutation-workflows.ts");
const PROBE_PATH = join(here, "..", "tests", "support", "determinism-probe-workflows.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turnResult = (overrides = {}) => ({
  workflowId: "wf:turn", roomId: "room:test", paneId: "pane:test", traceId: "trace-run-1",
  status: "COMPLETED", message: "Completed.",
  roomAgentOutcome: { status: "VERIFIED", pendingActionIds: [], executedActionCount: 1, statusReason: "Completed." },
  ...overrides
});

const SESSION_ID = Date.now().toString(36);
const queueItem = (missionId, agentRunId) => ({
  missionId,
  turn: {
    roomId: "room:test", paneId: "pane:test", prompt: "Run it.", artifactIds: [],
    agentRunId: `${agentRunId}-${SESSION_ID}`, permissionMode: null, collaborationMode: "default",
    traceId: `trace-run-${agentRunId}-${SESSION_ID}`
  }
});

const mainActivities = {
  recordDummyTurnStarted: () => ({ workflowId: "wf:dummy" }),
  recordDummyTurnCompleted: () => ({ ok: true }),
  runCodexAppServerTurn: () => turnResult(),
  runOpenCodeAgentTurn: () => turnResult({ message: "opencode done" }),
  runCliAgentTurn: () => turnResult({ message: "cli done" }),
  runRoomAgentBackgroundAction: () => ({ ok: true }),
  failRoomAgentBackgroundAction: () => undefined,
  checkRoomAgentSupervisorTurn: () => "RUN",
  discardRoomAgentSupervisorTurn: () => undefined,
  finishRoomAgentSupervisorTurn: () => undefined,
  prepareRoomAgentBackgroundContinuation: () => ({ state: "WAITING" }),
  settleRoomAgentBackgroundMission: () => true,
  markRoomAgentMissionStarted: () => undefined,
  markRoomAgentMissionFinished: () => undefined,
  markRoomAgentMissionContinued: () => undefined,
  dotGoalStep: () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" }),
  dotGoalObserve: () => ({ run: "COMPLETED", goalStatus: "COMPLETED" })
};

const memoryActivities = {
  refreshMemoryGraphSnapshot: () => ({
    status: "REFRESHED", generatedAt: "2026-10-23T00:00:01.000Z", sourceHash: "hash:aaaa1111",
    previousSourceHash: null, summary: { entryCount: 1 }, durationMs: 12
  }),
  refreshAllMonthsMemoryGraphSnapshot: () => undefined,
  reconcileStaleSpaceAgentSessions: () => undefined,
  createScheduledMemoryAudit: () => ({ id: "run:audit-1", workflowId: "space-memory-consolidation:run:audit-1" }),
  prepareMemoryConsolidation: () => ({ run: { id: "run:audit-1", workflowId: "space-memory-consolidation:run:audit-1" }, changeSetId: "changeset:1" }),
  finalizeMemoryRepair: () => ({ status: "FINALIZED" }),
  executePersistedMemoryChangeSet: () => ({ status: "APPLIED" })
};

async function record(name, workflowId, runner) {
  const history = await runner();
  const json = history.toJSON ? history.toJSON() : history;
  writeFileSync(join(FIXTURE_DIR, `${name}.json`), JSON.stringify({ workflowId, history: json }));
  console.log("recorded", name, (json.events ?? []).length, "events");
}

// History of exactly the handle's FIRST run. handle.fetchHistory() resolves the
// run id from the handle, which is empty on a start() handle and therefore
// follows to the latest run of the chain - wrong for a continue-as-new'd run.
function fetchRunHistory(env) {
  return async (handle) => {
    const events = [];
    let nextPageToken = undefined;
    for (;;) {
      const res = await env.client.workflowService.getWorkflowExecutionHistory({
        nextPageToken,
        namespace: env.client.options.namespace ?? "default",
        execution: { workflowId: handle.workflowId, runId: handle.firstExecutionRunId }
      });
      events.push(...(res.history?.events ?? []));
      nextPageToken = res.nextPageToken;
      if (nextPageToken == null || nextPageToken.length === 0) break;
    }
    return { events };
  };
}

async function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const executable = process.env.SPACE_TEST_TEMPORAL_TEST_SERVER
    ? { type: "existing-path", path: process.env.SPACE_TEST_TEMPORAL_TEST_SERVER }
    : undefined;
  const env = await TestWorkflowEnvironment.createTimeSkipping(
    executable ? { server: { executable } } : undefined
  );
  const bundles = [];
  // Worker.create binds activity functions at registration: wrap each name so a
  // later swap of `store[name]` (scenario-specific stubs) is honored per call.
  const wrap = (store) => {
    const out = {};
    for (const name of Object.keys(store)) out[name] = (...args) => store[name](...args);
    return out;
  };
  const makeWorker = async (taskQueue, workflowsPath, activities) => {
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities });
    bundles.push({ worker, running: worker.run() });
  };
  await makeWorker("record-main", WORKFLOWS_PATH, wrap(mainActivities));
  await makeWorker("record-legacy", PRE_PATCH_PATH, wrap(mainActivities));
  await makeWorker("record-probe", PROBE_PATH, wrap(mainActivities));
  await makeWorker("space-memory-maintenance", MAINTENANCE_PATH, wrap(memoryActivities));
  await makeWorker("space-memory-mutations", MUTATION_PATH, wrap(memoryActivities));

  const runHistory = fetchRunHistory(env);
  const start = (workflowId, taskQueue, workflowType, args, followRuns = true) =>
    env.client.workflow.start(workflowType, { workflowId, taskQueue, args, followRuns });
  const uid = (name) => `${name}-${SESSION_ID}`;

  console.log("workers up; recording");

  // 1. dummy turn
  await record("dummy-turn", "space-dummy-turn:record-1", async () => {
    const h = await start(uid("space-dummy-turn:record-1"), "record-main", "dummyTurnWorkflow", [{
      roomId: "room:test", paneId: "pane:test", prompt: "Run it.", artifactIds: [],
      agentRunId: "agent-run-1", permissionMode: null, collaborationMode: "default", traceId: "trace-run-1"
    }]);
    await h.result();
    return runHistory(h);
  });

  // 2. codex app server (native chat) turn
  await record("codex-app-server-turn", "space-turn:record-1", async () => {
    const h = await start(uid("space-turn:record-1"), "record-main", "codexAppServerTurnWorkflow", [{
      roomId: "room:test", paneId: "pane:test", prompt: "Run it.", artifactIds: [],
      agentRunId: "agent-run-1", permissionMode: null, collaborationMode: "default", traceId: "trace-run-1",
      agentSessionId: "session-1", agentAssistantMessageId: "assist-1"
    }]);
    await h.result();
    return runHistory(h);
  });

  // 3. dot goal (DONE fast path)
  await record("dot-goal", "space-dot-goal:record-1", async () => {
    const h = await start(uid("space-dot-goal:record-1"), "record-main", "dotGoalWorkflow", [{ goalId: "goal:record-1" }]);
    await h.result();
    return runHistory(h);
  });

  // 4. dot goal continue-as-new (300 WAITING iterations)
  await record("dot-goal-continue-as-new", "space-dot-goal:record-can", async () => {
    const step = () => ({ state: "WAITING", runId: null, goalStatus: "ACTIVE" });
    mainActivities.dotGoalStep = step;
    const h = await start(uid("space-dot-goal:record-can"), "record-main", "dotGoalWorkflow", [{ goalId: "goal:record-can" }], false);
    try { await h.result(); } catch (e) { console.log("can-run result error:", e?.constructor?.name, e?.message); }
    const history = await runHistory(h);
    mainActivities.dotGoalStep = () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" });
    await h.cancel().catch(() => undefined); // stop the follow-on run of the chain
    return history;
  });

  // 5. room agent supervisor (patched branch, settled snapshot)
  await record("room-agent-supervisor", "space-room-supervisor:record-1", async () => {
    const h = await start(uid("space-room-supervisor:record-1"), "record-main", "roomAgentSupervisorWorkflow",
      [{ roomId: "room:test", pending: [queueItem("mission:record-1", "agent-run-1")] }], false);
    await sleep(4000);
    const history = await runHistory(h);
    await h.cancel().catch(() => undefined);
    return history;
  });

  // 6. pre-patch (legacy) supervisor, settled snapshot
  await record("room-agent-supervisor-pre-patch", "space-room-supervisor:record-legacy", async () => {
    const h = await start(uid("space-room-supervisor:record-legacy"), "record-legacy", "roomAgentSupervisorWorkflow",
      [{ roomId: "room:test", pending: [queueItem("mission:record-1", "agent-run-1")] }], false);
    await sleep(4000);
    const history = await runHistory(h);
    await h.cancel().catch(() => undefined);
    return history;
  });

  // 7. room agent action (failure + report + rethrow)
  await record("room-agent-action", "space-room-action:action:record-1", async () => {
    mainActivities.runRoomAgentBackgroundAction = () => { throw new Error("action exploded"); };
    const h = await start(uid("space-room-action:action:record-1"), "record-main", "roomAgentActionWorkflow",
      [{ bridge: { roomId: "room:test", missionId: "mission:record-1" }, traceId: "trace-run-1" }]);
    try { await h.result(); } catch (e) { console.log("action-run result error:", e?.constructor?.name, e?.message); }
    mainActivities.runRoomAgentBackgroundAction = () => ({ ok: true });
    return runHistory(h);
  });

  // 8. memory maintenance (+ child consolidation with a change set)
  await record("memory-maintenance", "space-memory-maintenance:record-1", async () => {
    const h = await start(uid("space-memory-maintenance:record-1"), "space-memory-maintenance", "memoryMaintenanceWorkflow",
      [{ scheduledAt: "2026-10-23T00:00:00.000Z", traceId: "trace-run-1" }]);
    await h.result();
    return runHistory(h);
  });

  // 9. memory consolidation (standalone, with change set)
  await record("memory-consolidation", "space-memory-consolidation:record-1", async () => {
    const h = await start(uid("space-memory-consolidation:record-1"), "space-memory-maintenance", "memoryConsolidationWorkflow",
      [{ runId: "run:audit-1", traceId: "trace-run-1" }]);
    await h.result();
    return runHistory(h);
  });

  // 10. memory mutation
  await record("memory-mutation", "space-memory-mutation:record-1", async () => {
    const h = await start(uid("space-memory-mutation:record-1"), "space-memory-mutations", "memoryMutationWorkflow",
      [{ changeSetId: "changeset:1", traceId: "trace-run-1" }]);
    await h.result();
    return runHistory(h);
  });

  // 11. determinism probe
  await record("determinism-probe", "determinism-probe:record-1", async () => {
    const h = await start(uid("determinism-probe:record-1"), "record-probe", "determinismProbeWorkflow", [{ traceId: "trace-run-1" }]);
    await h.result();
    return runHistory(h);
  });

  for (const { worker } of bundles) await worker.shutdown();
  await env.teardown();
  console.log("recording complete");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
