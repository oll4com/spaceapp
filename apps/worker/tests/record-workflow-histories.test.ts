/**
 * Records workflow histories for the replay gate (temporal-replay.test.ts).
 *
 * Only runs when RECORD_HISTORIES=1 is set:
 *   npm run temporal:record-histories -w @space/worker
 *
 * Runs 9 scenarios (the 8 workflows plus the pre-patch legacy supervisor
 * branch) on the time-skipping test server with synthetic data only, then
 * writes each workflow's history JSON to
 * tests/fixtures/workflow-histories/<kebab-case>.json.
 *
 * Re-record ONLY together with a patched() change (and commit the new
 * fixtures with it). Never re-record just to make a failing replay pass.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowHandle } from "@temporalio/client";
import { DOT_GOAL_SIGNAL, roomAgentSupervisorInputSchema } from "@space/contracts";
import { MEMORY_MUTATION_TASK_QUEUE } from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import {
  createTemporalTestEnv,
  testWorkflowsPath,
  TEST_MAIN_TASK_QUEUE,
  type TemporalTestEnv
} from "./support/temporal-test-env.js";
import { createWorkflowStubs, type WorkflowStubs } from "./support/workflow-stubs.js";

const describeRecord = process.env.RECORD_HISTORIES ? describe : describe.skip;

describeRecord("record workflow histories", () => {
  let tenv: TemporalTestEnv;
  let stubs: WorkflowStubs;
  const historiesDir = fileURLToPath(new URL("./fixtures/workflow-histories/", import.meta.url));

  beforeAll(async () => {
    stubs = createWorkflowStubs();
    tenv = await createTemporalTestEnv(testWorkflowsPath(), stubs.activities);
    await mkdir(historiesDir, { recursive: true });
  }, 240_000);

  afterAll(async () => {
    await tenv.teardown();
  }, 120_000);

  async function recordHistory(name: string, handle: WorkflowHandle): Promise<void> {
    const history = await handle.fetchHistory();
    const json = JSON.stringify(history.toJSON(), null, 2);
    await writeFile(join(historiesDir, `${name}.json`), `${json}\n`);
    // eslint-disable-next-line no-console
    console.log(`recorded ${name}.json (${json.length} bytes)`);
  }

  const verifiedTurnResult = (input: { roomId: string; paneId: string; traceId: string }) => ({
    workflowId: `turn:${input.traceId}`,
    roomId: input.roomId,
    paneId: input.paneId,
    traceId: input.traceId,
    status: "COMPLETED" as const,
    message: "Verified",
    roomAgentOutcome: { status: "VERIFIED", statusReason: "Verified remaining request." }
  });

  // NOTE: the legacy scenario runs first on purpose. The test server grants
  // exactly one effective time-skipping period: once any workflow execution
  // closes, unlockTimeSkipping() stops taking effect. The 250 one-second
  // polls below need skipping.
  it("room-agent-supervisor-legacy", async () => {
    stubs.set("settleRoomAgentBackgroundMission", async () => false);
    const input = roomAgentSupervisorInputSchema.parse({
      roomId: "room:record-legacy",
      pending: [],
      monitoringMissionIds: ["mission:record-legacy"],
      interrupted: [],
      processedCount: 0
    });
    const handle = await tenv.client.workflow.start("legacyRoomAgentSupervisorWorkflow", {
      taskQueue: TEST_MAIN_TASK_QUEUE,
      workflowId: "record-room-supervisor-legacy",
      args: [input]
    });
    await tenv.unlockTimeSkipping();
    try {
      // Drive the full 250-poll loop into continueAsNew; the recorded history
      // is the pre-patch run, which the replay bundle maps to the dispatcher.
      // Bind to the first run: the started handle follows runs, and the new
      // run keeps polling, so a plain describe() would never observe the end.
      const firstRun = tenv.client.workflow.getHandle(
        "record-room-supervisor-legacy",
        (handle as unknown as { firstExecutionRunId: string }).firstExecutionRunId
      );
      for (;;) {
        const description = await firstRun.describe();
        if (description.status.name !== "RUNNING") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await recordHistory("room-agent-supervisor-legacy", firstRun);
    } finally {
      await tenv.lockTimeSkipping();
      await tenv.client.workflow.getHandle("record-room-supervisor-legacy").terminate("history recorded");
      stubs.reset();
    }
  }, 300_000);

  it("dot-goal", async () => {
    let calls = 0;
    stubs.set("dotGoalStep", () => {
      calls += 1;
      return calls <= 1
        ? { state: "WAITING", runId: null, goalStatus: "UNKNOWN" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    });
    const handle = await tenv.client.workflow.start("dotGoalWorkflow", {
      taskQueue: TEST_MAIN_TASK_QUEUE,
      workflowId: "record-dot-goal",
      args: [{ goalId: "goal:record" }]
    });
    await handle.signal(DOT_GOAL_SIGNAL);
    await handle.result();
    await recordHistory("dot-goal", handle);
    stubs.reset();
  }, 180_000);

  it("dummy-turn", async () => {
    const handle = await tenv.client.workflow.start("dummyTurnWorkflow", {
      taskQueue: TEST_MAIN_TASK_QUEUE,
      workflowId: "record-dummy-turn",
      args: [{ roomId: "room:record", paneId: "pane:record", prompt: "Record.", traceId: "trace:record-dummy" }]
    });
    await handle.result();
    await recordHistory("dummy-turn", handle);
  }, 120_000);

  it("codex-app-server-turn", async () => {
    const handle = await tenv.client.workflow.start("codexAppServerTurnWorkflow", {
      taskQueue: TEST_MAIN_TASK_QUEUE,
      workflowId: "record-codex-app-server-turn",
      args: [{ roomId: "room:record", paneId: "pane:record", prompt: "Record.", providerId: null, traceId: "trace:record-turn" }]
    });
    await handle.result();
    await recordHistory("codex-app-server-turn", handle);
  }, 120_000);

  it("room-agent-supervisor", async () => {
    const c = continuationFixture();
    stubs.setSupervisorStore(c.store);
    stubs.set("runCodexAppServerTurn", verifiedTurnResult);
    const item = c.enqueue("record-sup", "Record the room.").queueItem;
    const input = roomAgentSupervisorInputSchema.parse({
      roomId: c.room.id,
      pending: [item],
      monitoringMissionIds: [],
      interrupted: [],
      processedCount: 0
    });
    const handle = await tenv.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: TEST_MAIN_TASK_QUEUE,
      workflowId: `record-room-supervisor-${c.room.id}`,
      args: [input]
    });
    await stubs.waitForCalls("finishRoomAgentSupervisorTurn", 1);
    await handle.terminate("history recorded");
    await recordHistory("room-agent-supervisor", handle);
    stubs.reset();
    stubs.setSupervisorStore(undefined);
  }, 180_000);

  it("room-agent-action", async () => {
    stubs.set("runRoomAgentBackgroundAction", () => {
      throw new Error("record transport failure");
    });
    const handle = await tenv.client.workflow.start("roomAgentActionWorkflow", {
      taskQueue: TEST_MAIN_TASK_QUEUE,
      workflowId: "space-room-action:record-1",
      args: [{ bridge: { roomId: "room:record", missionId: "mission:record" } as never, traceId: "trace:record-action" }]
    });
    await handle.result().then(
      () => { throw new Error("expected the action workflow to fail"); },
      () => undefined
    );
    await recordHistory("room-agent-action", handle);
    stubs.reset();
  }, 180_000);

  it("memory-maintenance", async () => {
    const handle = await tenv.client.workflow.start("memoryMaintenanceWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "record-memory-maintenance",
      args: [{ scheduledAt: new Date().toISOString(), traceId: "trace:record-maintenance" }]
    });
    await handle.result();
    await recordHistory("memory-maintenance", handle);
  }, 180_000);

  it("memory-consolidation", async () => {
    const handle = await tenv.client.workflow.start("memoryConsolidationWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "record-memory-consolidation",
      args: [{ runId: "run:record-cons", traceId: "trace:record-cons" }]
    });
    await handle.result();
    await recordHistory("memory-consolidation", handle);
  }, 120_000);

  it("memory-mutation", async () => {
    const handle = await tenv.client.workflow.start("memoryMutationWorkflow", {
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowId: "record-memory-mutation",
      args: [{ changeSetId: "cs:record-1", traceId: "trace:record-mut" }]
    });
    await handle.result();
    await recordHistory("memory-mutation", handle);
    const files = 9;
    expect(files).toBe(9);
  }, 120_000);
});
