import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, type WorkerOptions } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { historyFromJSON } from "@temporalio/common/lib/proto-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");
const HISTORIES = path.resolve(__dirname, "fixtures/workflow-histories");

const DOT_QUEUE = "space-dot-goals";
const TURN_QUEUE = "space-turns";
const MAINTENANCE_QUEUE = "space-memory-maintenance";
const MUTATION_QUEUE = "space-memory-mutations";
const SUPERVISOR_QUEUE = "space-room-supervisor";

const WORKFLOWS = path.join(SRC, "workflows.ts");
const MAINTENANCE = path.join(SRC, "memory-maintenance-workflows.ts");
const MUTATION = path.join(SRC, "memory-mutation-workflows.ts");

function turn() {
  return {
    roomId: "room:record",
    paneId: "pane:record",
    prompt: "record a history",
    roomAgentOperatorRequest: "record a history",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    agentSessionId: "session:record",
    agentRunId: "agent_run:record",
    agentUserMessageId: "agent_msg:user-record",
    agentAssistantMessageId: "agent_msg:assistant-record",
    traceId: "trace:record"
  };
}

async function withWorker(
  env: TestWorkflowEnvironment,
  options: Pick<WorkerOptions, "taskQueue" | "activities" | "workflowsPath">,
  run: () => Promise<void>
) {
  const worker = await Worker.create({ connection: env.nativeConnection, ...options });
  await worker.runUntil(run());
}

async function record(
  env: TestWorkflowEnvironment,
  file: string,
  handle: { workflowId: string; result(): Promise<unknown> },
  options: { cancelled?: boolean } = {}
) {
  // Read the history only after the run closed: reading it earlier returns the
  // first events of a still-open run, which replays trivially and would hide a
  // determinism break. A workflow that parks forever (the supervisor) is closed
  // by cancelling it, and that rejection is the expected close, not a failure.
  const result = options.cancelled
    ? await handle.result().catch(() => undefined)
    : await handle.result();
  const history = await env.client.workflow.getHandle(handle.workflowId).fetchHistory();
  if (!history.events?.length) throw new Error(`empty history for ${file}`);
  await mkdir(HISTORIES, { recursive: true });
  await writeFile(
    path.join(HISTORIES, `${file}.json`),
    JSON.stringify(history.events, null, 1),
    "utf8"
  );
  return result;
}

/** Run each workflow once in the real sandbox and store its history. */
export async function recordHistories(): Promise<string[]> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const written: string[] = [];
  try {
    await withWorker(
      env,
      {
        taskQueue: DOT_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          dotGoalStep: async () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" }),
          dotGoalObserve: async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" })
        }
      },
      async () => {
        const handle = await env.client.workflow.start("dotGoalWorkflow", {
          args: [{ goalId: "goal:record" }],
          taskQueue: DOT_QUEUE,
          workflowId: "wf:record:dot-done"
        });
        await record(env, "dotGoalWorkflow", handle);
        written.push("dotGoalWorkflow");
      }
    );

    await withWorker(
      env,
      {
        taskQueue: TURN_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          recordDummyTurnStarted: async () => ({ workflowId: "wf:record:turn" }),
          recordDummyTurnCompleted: async () => ({
            workflowId: "wf:record:turn",
            roomId: "room:record",
            paneId: "pane:record",
            traceId: "trace:record"
          })
        }
      },
      async () => {
        const handle = await env.client.workflow.start("dummyTurnWorkflow", {
          args: [turn()],
          taskQueue: TURN_QUEUE,
          workflowId: "wf:record:turn"
        });
        await record(env, "dummyTurnWorkflow", handle);
        written.push("dummyTurnWorkflow");
      }
    );

    await withWorker(
      env,
      {
        taskQueue: MUTATION_QUEUE,
        workflowsPath: MUTATION,
        activities: {
          executePersistedMemoryChangeSet: async (input: { changeSetId: string }) => ({
            changeSetId: input.changeSetId,
            applied: true
          })
        }
      },
      async () => {
        const handle = await env.client.workflow.start("memoryMutationWorkflow", {
          args: [{ changeSetId: "cs:record", traceId: "trace:record" }],
          taskQueue: MUTATION_QUEUE,
          workflowId: "wf:record:mutation"
        });
        await record(env, "memoryMutationWorkflow", handle);
        written.push("memoryMutationWorkflow");
      }
    );

    await withWorker(
      env,
      {
        taskQueue: MAINTENANCE_QUEUE,
        workflowsPath: MAINTENANCE,
        activities: {
          refreshMemoryGraphSnapshot: async () => ({ sourceHash: "hash:record" }),
          refreshAllMonthsMemoryGraphSnapshot: async () => ({ sourceHash: "hash:record" }),
          reconcileStaleSpaceAgentSessions: async () => ({ reconciled: 0 }),
          createScheduledMemoryAudit: async () => ({ id: "run:record", workflowId: "wf:record:consolidation" }),
          prepareMemoryConsolidation: async () => ({ run: { runId: "run:record" }, changeSetId: null })
        }
      },
      async () => {
        const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
          args: [{ traceId: "trace:record" }],
          taskQueue: MAINTENANCE_QUEUE,
          workflowId: "wf:record:maintenance"
        });
        await record(env, "memoryMaintenanceWorkflow", handle);
        written.push("memoryMaintenanceWorkflow");
      }
    );

    await withWorker(
      env,
      {
        taskQueue: TURN_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          runCodexAppServerTurn: async (input: { roomId: string; paneId: string }) => ({
            workflowId: "wf:record:codex-turn",
            roomId: input.roomId,
            paneId: input.paneId,
            traceId: "trace:record"
          })
        }
      },
      async () => {
        const handle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
          args: [turn()],
          taskQueue: TURN_QUEUE,
          workflowId: "wf:record:codex-turn"
        });
        await record(env, "codexAppServerTurnWorkflow", handle);
        written.push("codexAppServerTurnWorkflow");
      }
    );

    await withWorker(
      env,
      {
        taskQueue: TURN_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          runRoomAgentBackgroundAction: async () => ({ actionId: "action:record", ran: true }),
          failRoomAgentBackgroundAction: async () => undefined
        }
      },
      async () => {
        const handle = await env.client.workflow.start("roomAgentActionWorkflow", {
          args: [{ bridge: { roomId: "room:record", missionId: "mission:record" }, actionId: "action:record", traceId: "trace:record" }],
          taskQueue: TURN_QUEUE,
          workflowId: "wf:record:room-action"
        });
        await record(env, "roomAgentActionWorkflow", handle);
        written.push("roomAgentActionWorkflow");
      }
    );

    await withWorker(
      env,
      {
        taskQueue: MAINTENANCE_QUEUE,
        workflowsPath: MAINTENANCE,
        activities: {
          prepareMemoryConsolidation: async () => ({ run: { runId: "run:record", status: "COMPLETED" }, changeSetId: null })
        }
      },
      async () => {
        const handle = await env.client.workflow.start("memoryConsolidationWorkflow", {
          args: [{ runId: "run:record", traceId: "trace:record" }],
          taskQueue: MAINTENANCE_QUEUE,
          workflowId: "wf:record:consolidation"
        });
        await record(env, "memoryConsolidationWorkflow", handle);
        written.push("memoryConsolidationWorkflow");
      }
    );

    // The supervisor never returns; cancel it so the run closes and the history
    // (which is what replay reads) is complete.
    await withWorker(
      env,
      {
        taskQueue: SUPERVISOR_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          checkRoomAgentSupervisorTurn: async () => "SKIP",
          discardRoomAgentSupervisorTurn: async () => undefined,
          finishRoomAgentSupervisorTurn: async () => undefined,
          prepareRoomAgentBackgroundContinuation: async () => ({ state: "DONE" })
        }
      },
      async () => {
        const pending = [{ missionId: "mission:record", turn: turn() }];
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          args: [{ roomId: "room:record", pending, monitoringMissionIds: [], interrupted: [], processedCount: 0 }],
          taskQueue: SUPERVISOR_QUEUE,
          workflowId: "wf:record:supervisor"
        });
        await env.sleep("5 seconds");
        await handle.cancel();
        await record(env, "roomAgentSupervisorWorkflow", handle, { cancelled: true });
        written.push("roomAgentSupervisorWorkflow");
      }
    );

    await withWorker(
      env,
      {
        taskQueue: SUPERVISOR_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          settleRoomAgentBackgroundMission: async () => true,
          markRoomAgentMissionStarted: async () => undefined,
          markRoomAgentMissionFinished: async () => undefined,
          markRoomAgentMissionContinued: async () => undefined,
          prepareRoomAgentBackgroundContinuation: async () => ({ state: "DONE" })
        }
      },
      async () => {
        // Monitoring-only entry: the legacy branch then polls its boolean settle
        // activity, which is the behaviour only this branch has.
        const handle = await env.client.workflow.start("legacyRoomAgentSupervisorWorkflow", {
          args: [{ roomId: "room:record", pending: [], monitoringMissionIds: ["mission:record"], interrupted: [], processedCount: 0 }],
          taskQueue: SUPERVISOR_QUEUE,
          workflowId: "wf:record:legacy-supervisor"
        });
        await env.sleep("5 seconds");
        await handle.cancel();
        await record(env, "legacyRoomAgentSupervisorWorkflow", handle, { cancelled: true });
        written.push("legacyRoomAgentSupervisorWorkflow");
      }
    );
  } finally {
    await env.teardown();
  }
  return written;
}

/** Replay every stored history against the current workflow code. */
export async function replayHistories(): Promise<
  Array<{ file: string; workflowId: string; error?: string }>
> {
  let files: string[];
  try {
    files = (await readdir(HISTORIES)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const results: Array<{ file: string; workflowId: string; error?: string }> = [];
  const bundleFor = (file: string) =>
    file.startsWith("memoryMaintenance") || file.startsWith("memoryConsolidation") ? MAINTENANCE
      : file.startsWith("memoryMutation") ? MUTATION
        : WORKFLOWS;

  for (const file of files) {
    const events = JSON.parse(await readFile(path.join(HISTORIES, file), "utf8"));
    const history = historyFromJSON({ events });
    const workflowId = `replay:${file}`;
    const errors: string[] = [];
    const worker = await Worker.create({
      connection: undefined,
      taskQueue: "space-replay",
      workflowsPath: bundleFor(file),
      activities: {},
      replayWorker: true
    } as unknown as WorkerOptions);
    void worker;
    const iterable = Worker.runReplayHistories(
      {
        workflowsPath: bundleFor(file),
        taskQueue: "space-replay",
        activities: {}
      },
      [{ workflowId, history }]
    );
    for await (const result of iterable) {
      if (result.error) errors.push(`${result.error.name}: ${result.error.message}`);
    }
    results.push({ file, workflowId, ...(errors.length ? { error: errors.join("; ") } : {}) });
  }
  return results;
}

if (process.argv[2] === "--record") {
  recordHistories().then(
    (written) => {
      console.log("RECORDED", JSON.stringify(written));
      process.exit(0);
    },
    (error) => {
      console.error("RECORD FAILED", error);
      process.exit(1);
    }
  );
}
