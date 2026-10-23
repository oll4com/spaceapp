import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, type WorkerOptions } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");
const WORKFLOWS = path.join(SRC, "workflows.ts");
const MAINTENANCE = path.join(SRC, "memory-maintenance-workflows.ts");

const TURN_QUEUE = "space-turns";
const MAINTENANCE_QUEUE = "space-memory-maintenance";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 300_000);

afterAll(async () => {
  await env?.teardown();
});

async function withWorker(
  options: Pick<WorkerOptions, "taskQueue" | "workflowsPath" | "activities">,
  run: () => Promise<void>
): Promise<void> {
  const worker = await Worker.create({ connection: env.nativeConnection, ...options });
  await worker.runUntil(run());
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room:rest",
    paneId: "pane:rest",
    prompt: "do the thing",
    roomAgentOperatorRequest: "do the thing",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    agentSessionId: "session:rest",
    agentRunId: "agent_run:rest",
    agentUserMessageId: "agent_msg:user-rest",
    agentAssistantMessageId: "agent_msg:assistant-rest",
    traceId: "trace:rest",
    ...overrides
  };
}

describe("memoryConsolidationWorkflow", () => {
  it("stops after prepare when the activity reports no change set", async () => {
    const calls: string[] = [];
    await withWorker(
      {
        taskQueue: MAINTENANCE_QUEUE,
        workflowsPath: MAINTENANCE,
        activities: {
          prepareMemoryConsolidation: async () => {
            calls.push("prepare");
            return { run: { runId: "run:noop" }, changeSetId: null };
          },
          executePersistedMemoryChangeSet: async () => {
            calls.push("mutate");
            return { changeSetId: "unexpected" };
          },
          finalizeMemoryRepair: async () => {
            calls.push("finalize");
            return { runId: "run:noop" };
          }
        }
      },
      async () => {
        const result = await env.client.workflow.execute("memoryConsolidationWorkflow", {
          args: [{ runId: "run:noop", traceId: "trace:noop" }],
          taskQueue: MAINTENANCE_QUEUE,
          workflowId: "wf:consolidation:noop"
        });
        expect(result).toEqual({ runId: "run:noop" });
      }
    );
    expect(calls).toEqual(["prepare"]);
  }, 240_000);

  it("hands the change set to the mutation task queue and finalizes the repair", async () => {
    // memoryConsolidationWorkflow proxies executePersistedMemoryChangeSet onto
    // MEMORY_MUTATION_TASK_QUEUE. Two workers poll while the run is in flight;
    // the mutation worker is stopped as soon as the run settles.
    const calls: string[] = [];
    const maintenance = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MAINTENANCE_QUEUE,
      workflowsPath: MAINTENANCE,
      activities: {
        prepareMemoryConsolidation: async () => {
          calls.push("prepare");
          return { run: { runId: "run:work" }, changeSetId: "cs:work" };
        },
        finalizeMemoryRepair: async (input: { runId: string }) => {
          calls.push(`finalize:${input.runId}`);
          return { runId: input.runId, repaired: true };
        }
      }
    });
    const mutation = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "space-memory-mutations",
      activities: {
        executePersistedMemoryChangeSet: async (input: { changeSetId: string }) => {
          calls.push(`mutate:${input.changeSetId}`);
          return { changeSetId: input.changeSetId, applied: true };
        }
      }
    });

    let releaseMutation: () => void = () => undefined;
    const mutationStop = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutationRun = mutation.runUntil(mutationStop);

    try {
      const result = await maintenance.runUntil(() =>
        env.client.workflow.execute("memoryConsolidationWorkflow", {
          args: [{ runId: "run:work", traceId: "trace:work" }],
          taskQueue: MAINTENANCE_QUEUE,
          workflowId: "wf:consolidation:work"
        })
      );
      expect(result).toEqual({ runId: "run:work", repaired: true });
    } finally {
      releaseMutation();
      await mutationRun;
    }
    expect(calls).toEqual(["prepare", "mutate:cs:work", "finalize:run:work"]);
  }, 180_000);
});

describe("roomAgentActionWorkflow", () => {
  it("returns the activity result on success and records no failure", async () => {
    const calls: string[] = [];
    await withWorker(
      {
        taskQueue: TURN_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          runRoomAgentBackgroundAction: async () => {
            calls.push("run");
            return { actionId: "action:1", status: "COMPLETED" };
          },
          failRoomAgentBackgroundAction: async () => {
            calls.push("fail");
          }
        }
      },
      async () => {
        const result = await env.client.workflow.execute("roomAgentActionWorkflow", {
          args: [
            {
              actionId: "action:1",
              traceId: "trace:action",
              bridge: { roomId: "room:rest", missionId: "mission:rest" }
            }
          ],
          taskQueue: TURN_QUEUE,
          workflowId: "wf:room-action:ok"
        });
        expect(result).toEqual({ actionId: "action:1", status: "COMPLETED" });
      }
    );
    expect(calls).toEqual(["run"]);
  }, 240_000);

  it("records the background failure on the patched branch before rethrowing", async () => {
    const failures: Array<Record<string, unknown>> = [];
    await withWorker(
      {
        taskQueue: TURN_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          runRoomAgentBackgroundAction: async () => {
            throw new Error("transport failed");
          },
          failRoomAgentBackgroundAction: async (input: Record<string, unknown>) => {
            failures.push(input);
          }
        }
      },
      async () => {
        const failure = await env.client.workflow
          .execute("roomAgentActionWorkflow", {
            args: [
              {
                actionId: "action:2",
                traceId: "trace:action-fail",
                bridge: { roomId: "room:rest", missionId: "mission:rest" }
              }
            ],
            taskQueue: TURN_QUEUE,
            workflowId: "wf:room-action:fail"
          })
          .then(
            () => null,
            (error: unknown) => error
          );
        expect(failure).not.toBeNull();
      }
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      roomId: "room:rest",
      missionId: "mission:rest",
      actionId: "action:2",
      cancelled: false
    });
  }, 240_000);
});

describe("codexAppServerTurnWorkflow", () => {
  it("routes an ordinary turn to the room agent activity", async () => {
    const calls: string[] = [];
    await withWorker(
      {
        taskQueue: TURN_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          runCodexAppServerTurn: async () => {
            calls.push("room-agent");
            return { status: "COMPLETED", message: "done" };
          },
          runOpenCodeAgentTurn: async () => {
            calls.push("opencode");
            return { status: "COMPLETED", message: "opencode" };
          },
          runCliAgentTurn: async () => {
            calls.push("cli");
            return { status: "COMPLETED", message: "cli" };
          }
        }
      },
      async () => {
        const result = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
          args: [turn()],
          taskQueue: TURN_QUEUE,
          workflowId: "wf:turn:room-agent"
        });
        expect(result).toEqual({ status: "COMPLETED", message: "done" });
      }
    );
    expect(calls).toEqual(["room-agent"]);
  }, 240_000);

  it("routes an opencode provider to the opencode activity", async () => {
    const calls: string[] = [];
    await withWorker(
      {
        taskQueue: TURN_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          runCodexAppServerTurn: async () => {
            calls.push("room-agent");
            return { status: "COMPLETED", message: "room" };
          },
          runOpenCodeAgentTurn: async () => {
            calls.push("opencode");
            return { status: "COMPLETED", message: "opencode" };
          }
        }
      },
      async () => {
        const result = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
          args: [turn({ providerId: "opencode" })],
          taskQueue: TURN_QUEUE,
          workflowId: "wf:turn:opencode"
        });
        expect(result).toEqual({ status: "COMPLETED", message: "opencode" });
      }
    );
    expect(calls).toEqual(["opencode"]);
  }, 240_000);
});
