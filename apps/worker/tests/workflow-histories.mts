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
  handle: { workflowId: string; result(): Promise<unknown> }
) {
  // Read the history only after the run closed: reading it earlier returns the
  // first events of a still-open run, which replays trivially and would hide a
  // determinism break.
  const result = await handle.result();
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
    file.startsWith("memoryMaintenance") ? MAINTENANCE
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
