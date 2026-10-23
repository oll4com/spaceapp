/**
 * Records synthetic workflow histories for the replay gate (issue #60).
 *
 * Skipped unless RECORD_HISTORIES=1; run with:
 *   npm run temporal:record-histories -w @space/worker
 *
 * Histories are recorded from the REAL workflow code on the time-skipping
 * test server with stubbed activities, and contain synthetic data only.
 * The supervisor pre-patch history is recorded from the verbatim legacy
 * branch copy in tests/support/legacy-supervisor-recording.ts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as proto from "@temporalio/proto";
import { DOT_GOAL_SIGNAL, ROOM_AGENT_STOP_SIGNAL } from "@space/contracts";
import { ActivityStubs, buildActivities, makeGate } from "./activity-stubs.js";
import { nativeTurnInput, roomAgentTurnInput, supervisorInput, supervisorQueueItem } from "./stubs.js";
import {
  createSandboxEnv,
  MAIN_TASK_QUEUE,
  MEMORY_MAINTENANCE_TASK_QUEUE,
  MEMORY_MUTATION_TASK_QUEUE,
  buildWorkflowBundle,
  legacySupervisorEntry,
  waitForRunIdChange,
  type SandboxEnv
} from "./sandbox.js";

const recordMode = process.env.RECORD_HISTORIES === "1";
const suite = recordMode ? describe : describe.skip;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../fixtures/workflow-histories");
const LEGACY_TASK_QUEUE = MAIN_TASK_QUEUE + "-legacy";

const stubs = new ActivityStubs();
let env: SandboxEnv;

async function recordHistory(workflowId: string, runId: string | undefined, fileName: string): Promise<void> {
  const handle = env.testEnv.client.workflow.getHandle(workflowId, runId);
  // Normalize enum names to their numeric proto values so the replay worker
  // can encode the history back to protobuf without any conversion layer.
  const history = proto.temporal.api.history.v1.History.fromObject(await handle.fetchHistory());
  await mkdir(FIXTURES_DIR, { recursive: true });
  await writeFile(resolve(FIXTURES_DIR, fileName), JSON.stringify({ workflowId, history }, null, 2) + "\n");
}

suite("record workflow histories for the replay gate", () => {
  beforeAll(async () => {
    env = await createSandboxEnv();
    await env.startWorker(MAIN_TASK_QUEUE, buildActivities(stubs));
    await env.startWorker(MEMORY_MAINTENANCE_TASK_QUEUE, buildActivities(stubs));
    await env.startWorker(MEMORY_MUTATION_TASK_QUEUE, buildActivities(stubs));
    await env.startWorker(LEGACY_TASK_QUEUE, buildActivities(stubs), await buildWorkflowBundle(legacySupervisorEntry()));
  }, 180000);

  afterAll(async () => {
    await env.teardown();
  }, 60000);

  it("records one history per workflow plus the pre-patch supervisor", async () => {
    stubs.reset();

    // dotGoalWorkflow: one WAITING step, a wake-up signal, then DONE.
    const steps = [
      { state: "WAITING", runId: null, goalStatus: "UNKNOWN" },
      { state: "DONE", runId: null, goalStatus: "COMPLETED" }
    ];
    stubs.override("dotGoalStep", (_input, index) => steps[index]);
    let handle = await env.testEnv.client.workflow.start("dotGoalWorkflow", {
      taskQueue: MAIN_TASK_QUEUE, workflowId: "fixture-dot-goal", args: [{ goalId: "goal-fixture-01" }]
    });
    await stubs.waitForCall("dotGoalStep", 1);
    await handle.signal(DOT_GOAL_SIGNAL);
    await handle.result();
    await recordHistory("fixture-dot-goal", undefined, "dotGoalWorkflow.json");

    stubs.reset();
    // dummyTurnWorkflow.
    handle = await env.testEnv.client.workflow.start("dummyTurnWorkflow", {
      taskQueue: MAIN_TASK_QUEUE, workflowId: "fixture-dummy-turn", args: [nativeTurnInput("room-fixture-01", "dummy")]
    });
    await handle.result();
    await recordHistory("fixture-dummy-turn", undefined, "dummyTurnWorkflow.json");

    stubs.reset();
    // codexAppServerTurnWorkflow (room-agent turn).
    handle = await env.testEnv.client.workflow.start("codexAppServerTurnWorkflow", {
      taskQueue: MAIN_TASK_QUEUE,
      workflowId: "fixture-codex-turn",
      args: [roomAgentTurnInput("room-fixture-01", "mission-fixture-01", "fixture")]
    });
    await handle.result();
    await recordHistory("fixture-codex-turn", undefined, "codexAppServerTurnWorkflow.json");

    stubs.reset();
    // roomAgentSupervisorWorkflow (current patched branch), closed by
    // continueAsNew after the 50th processed mission.
    const supRoom = "room-fixture-sup";
    const supItem = supervisorQueueItem(supRoom, "mission-fixture-02", "sup");
    handle = await env.testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: MAIN_TASK_QUEUE,
      workflowId: "fixture-supervisor",
      args: [supervisorInput(supRoom, { pending: [supItem], processedCount: 49 })]
    });
    const supervisorRunId = (await handle.describe()).runId;
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    await waitForRunIdChange(handle, supervisorRunId, 30000);
    await recordHistory("fixture-supervisor", supervisorRunId, "roomAgentSupervisorWorkflow.json");
    await handle.cancel().catch(() => undefined);
    await handle.result().catch(() => undefined);

    stubs.reset();
    // roomAgentSupervisorWorkflow pre-patch branch: one mission completes,
    // one pending mission is interrupted by a stop signal, then the run is
    // cancelled while idle (like a pre-patch execution without the patch
    // marker).
    const legacyRoom = "room-fixture-legacy";
    const legacyItem1 = supervisorQueueItem(legacyRoom, "mission-fixture-03", "legacy-a");
    const legacyItem2 = supervisorQueueItem(legacyRoom, "mission-fixture-04", "legacy-b");
    const gate = makeGate();
    stubs.override("markRoomAgentMissionStarted", async (input) => {
      if (input.missionId === "mission-fixture-03") await gate.promise;
      return null;
    });
    handle = await env.testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: LEGACY_TASK_QUEUE,
      workflowId: "fixture-supervisor-pre-patch",
      args: [supervisorInput(legacyRoom, { pending: [legacyItem1, legacyItem2] })]
    });
    await stubs.waitForCall("markRoomAgentMissionStarted");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission-fixture-04", reason: "Synthetic pre-patch stop." });
    gate.open();
    await stubs.waitForCall("markRoomAgentMissionFinished", 2);
    await handle.cancel();
    await handle.result().catch(() => undefined);
    await recordHistory("fixture-supervisor-pre-patch", undefined, "roomAgentSupervisorWorkflow.pre-patch.json");

    stubs.reset();
    // roomAgentActionWorkflow failure path.
    stubs.override("runRoomAgentBackgroundAction", () => {
      throw new Error("synthetic background action failure");
    });
    handle = await env.testEnv.client.workflow.start("roomAgentActionWorkflow", {
      taskQueue: MAIN_TASK_QUEUE,
      workflowId: "fixture-room-action",
      args: [{ actionId: "act-fixture-01", bridge: { roomId: "room-fixture-01", missionId: "mission-fixture-05" }, traceId: "trace:fixture-action" }]
    });
    await handle.result().catch(() => undefined);
    await recordHistory("fixture-room-action", undefined, "roomAgentActionWorkflow.json");

    stubs.reset();
    // memoryMaintenanceWorkflow with its consolidation child.
    handle = await env.testEnv.client.workflow.start("memoryMaintenanceWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "fixture-memory-maintenance",
      args: [{ scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:fixture-memory" }]
    });
    await handle.result();
    await recordHistory("fixture-memory-maintenance", undefined, "memoryMaintenanceWorkflow.json");

    stubs.reset();
    // memoryConsolidationWorkflow.
    handle = await env.testEnv.client.workflow.start("memoryConsolidationWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "fixture-memory-consolidation",
      args: [{ runId: "run-trace:fixture-memory", traceId: "trace:fixture-memory" }]
    });
    await handle.result();
    await recordHistory("fixture-memory-consolidation", undefined, "memoryConsolidationWorkflow.json");

    stubs.reset();
    // memoryMutationWorkflow.
    handle = await env.testEnv.client.workflow.start("memoryMutationWorkflow", {
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowId: "fixture-memory-mutation",
      args: [{ changeSetId: "changeset-fixture-01", traceId: "trace:fixture-memory" }]
    });
    await handle.result();
    await recordHistory("fixture-memory-mutation", undefined, "memoryMutationWorkflow.json");

    const expected = [
      "dotGoalWorkflow.json",
      "dummyTurnWorkflow.json",
      "codexAppServerTurnWorkflow.json",
      "roomAgentSupervisorWorkflow.json",
      "roomAgentSupervisorWorkflow.pre-patch.json",
      "roomAgentActionWorkflow.json",
      "memoryMaintenanceWorkflow.json",
      "memoryConsolidationWorkflow.json",
      "memoryMutationWorkflow.json"
    ];
    const { readdir, stat } = await import("node:fs/promises");
    const files = (await readdir(FIXTURES_DIR)).filter((file) => file.endsWith(".json")).sort();
    expect(files).toEqual([...expected].sort());
    for (const file of files) {
      const info = await stat(resolve(FIXTURES_DIR, file));
      console.log("recorded fixture", file, info.size, "bytes");
    }
  }, 300000);
});
